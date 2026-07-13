import { Component } from '@angular/core';

import { BoulderMapComponent } from './components/boulder-map/boulder-map';

import { BOULDER_SPOTS } from './data/boulder-spots';

@Component({
  selector: 'app-root',

  imports: [
    BoulderMapComponent
  ],

  templateUrl: './app.html',

  styleUrl: './app.css'
})
export class App {

  spots = BOULDER_SPOTS;

}